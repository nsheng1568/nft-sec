// SPDX-License-Identifier: BUSL-1.1

pragma solidity 0.8.4;

import "./loans/direct/loanTypes/DirectLoanBaseMinimal.sol";

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import "@openzeppelin/contracts/token/ERC1155/extensions/ERC1155Supply.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";

contract NftSec is ERC1155Supply {

    struct Underlying {
        uint256 loanPrincipal;
        uint256 loanProceeds;
        uint64 loanEndTime;
        uint256 auctionEndTime;
        uint32 loanId;
        bool liquidated;
    }

    struct Product {
        address owner;
        uint256 tokenOffset;
        uint256[] trancheInterestRates;
        uint256[] trancheNotionals;
        Underlying[] underlyings;
        uint256[] tranchePayouts;
        bool payoutsComputed;
        uint256 startTime;
    }

    struct UnderlyingLookup {
        uint32 productId;
        uint32 underlyingIndex;
    }

    address public constant WETH = address(0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2);
    address public constant NFTFI = address(0x8252Df1d8b29057d1Afe3062bf5a64D503152BC8);
    address public constant ERC721_WRAPPER = address(0xB2C2fCe38a0B7A89aB51F046B7052892Ba55EB2B);
    uint64 public constant DAY_IN_SECONDS = 86400;

    mapping(uint32 => Product) public productIdToProduct;
    mapping(address => mapping(uint256 => UnderlyingLookup)) public nftIdToLookup;
    uint32 public currentProductId = 0;
    uint256 public currentTokenOffset = 0;

    constructor() ERC1155("") {}

    function mint(
        uint256[] calldata trancheInterestRates,
        uint256[] calldata trancheNotionals,
        uint32[] calldata loanIds
    ) external {
        require(trancheInterestRates.length < 32, "Too many tranches");
        require(trancheInterestRates.length == trancheNotionals.length, "Number of interest rates and notionals don't match");

        Product storage product = productIdToProduct[currentProductId];
        for (uint32 i = 0; i < loanIds.length; i++) {
            Underlying storage underlying = product.underlyings[i];
            underlying.loanId = loanIds[i];
            uint256 loanRepayment;
            uint256 nftId;
            uint32 loanDuration;
            uint16 loanAdminFee;
            uint64 loanStartTime;
            address nftContract;
            {
                (
                    underlying.loanPrincipal,
                    loanRepayment,
                    nftId,
                    ,
                    loanDuration,
                    ,
                    loanAdminFee,
                    ,
                    loanStartTime,
                    nftContract,
                ) = DirectLoanBaseMinimal(NFTFI).loanIdToLoan(underlying.loanId);
            }

            underlying.loanProceeds = (loanRepayment - underlying.loanPrincipal) * (10000 - loanAdminFee) / 10000 + underlying.loanPrincipal;
            underlying.loanEndTime = loanStartTime + loanDuration;
            underlying.auctionEndTime = block.timestamp + 35 * DAY_IN_SECONDS;
            nftIdToLookup[nftContract][nftId] = UnderlyingLookup(currentProductId, i);
        }
        product.owner = msg.sender;
        product.tokenOffset = currentTokenOffset;
        product.startTime = block.timestamp;
        for (uint8 trancheId = 0; trancheId < trancheInterestRates.length; trancheId++) {
            product.trancheInterestRates.push(trancheInterestRates[trancheId]);
            product.trancheNotionals.push(trancheNotionals[trancheId]);
        }
        currentProductId += 1;

        for (uint8 trancheId = 0; trancheId < trancheNotionals.length; trancheId++) {
            _mint(address(this), trancheId + currentTokenOffset, trancheNotionals[trancheId], "");
        }
        _mint(address(this), currentTokenOffset + trancheNotionals.length, 1, "");
        currentTokenOffset += trancheNotionals.length + 1;
    }

    function buyTokens(uint32 productId, uint8 trancheId, uint256 amount) external {
        Product memory product = productIdToProduct[productId];
        require(balanceOf(address(this), trancheId + product.tokenOffset) > 0, "No supply remaining");
        uint256 price = _getTokenPrice(product.startTime);
        IERC20(WETH).transferFrom(msg.sender, product.owner, price * amount);
        safeTransferFrom(address(this), msg.sender, trancheId + product.tokenOffset, amount, "");
    }

    function redeemTokens(uint32 productId) external {
        Product storage product = productIdToProduct[productId];
        IERC20 weth = IERC20(WETH);

        if (!product.payoutsComputed) {
            DirectLoanBaseMinimal nftfi = DirectLoanBaseMinimal(NFTFI);
            uint256 totalProceeds = 0;
            for (uint32 i = 0; i < product.underlyings.length; i++) {
                if (product.underlyings[i].liquidated || nftfi.loanRepaidOrLiquidated(product.underlyings[i].loanId)) {
                    totalProceeds += product.underlyings[i].loanProceeds;
                }
            }
            totalProceeds -= 10**17; // computation bounty
            for (uint8 trancheId = 0; trancheId < product.trancheNotionals.length; trancheId++) {
                uint256 expectedPayout = product.trancheNotionals[trancheId] * (1 + product.trancheInterestRates[trancheId]);
                if (totalProceeds >= expectedPayout) {
                    product.tranchePayouts[trancheId] = expectedPayout;
                    totalProceeds -= expectedPayout;
                } else {
                    product.tranchePayouts[trancheId] = totalProceeds;
                    totalProceeds = 0;
                }
            }
            if (totalProceeds > 0) {
                product.tranchePayouts.push(Math.min(weth.balanceOf(address(this)), totalProceeds)); // remaining goes to residual
            }
            product.payoutsComputed = true;
            weth.transfer(msg.sender, 10**17); // pay computation bounty
        }

        for (
            uint256 trancheId = 0;
            trancheId < product.trancheInterestRates.length + 1;
            trancheId++
        ) {
            uint256 tokenId = trancheId + product.tokenOffset;
            uint256 balance = balanceOf(msg.sender, tokenId);
            if (balance > 0) {
                _burn(msg.sender, tokenId, balance);
                weth.transfer(msg.sender, product.tranchePayouts[trancheId] * balance / product.trancheNotionals[trancheId]);
            }
        }
    }

    function liquidateNft(address nftContract, uint256 nftId) external {
        Underlying memory underlying = _getUnderlying(nftContract, nftId);
        uint256 nftPrice = _getNftPrice(underlying.loanPrincipal, underlying.loanEndTime, underlying.auctionEndTime);
        IERC20 weth = IERC20(WETH);
        require(weth.allowance(address(this), msg.sender) >= nftPrice, "Didn't approve enough wETH to liquidate");

        DirectLoanBaseMinimal(NFTFI).liquidateOverdueLoan(underlying.loanId);
        weth.transferFrom(msg.sender, address(this), nftPrice);
        IERC721(nftContract).transferFrom(address(this), msg.sender, nftId);
        underlying.loanProceeds = nftPrice;
    }

    function getTokenPrice(uint32 productId, uint8 trancheId) external view returns (uint256) {
        Product memory product = productIdToProduct[productId];
        require(balanceOf(address(this), trancheId + product.tokenOffset) > 0, "No supply remaining");
        return _getTokenPrice(product.startTime);
    }

    function getNftPrice(address nftContract, uint256 nftId) external view returns (uint256) {
        Underlying memory underlying = _getUnderlying(nftContract, nftId);
        require(block.timestamp > underlying.loanEndTime, "Loan not expired yet");
        require(!DirectLoanBaseMinimal(NFTFI).loanRepaidOrLiquidated(underlying.loanId), "Loan already repaid or liquidated");
        return _getNftPrice(underlying.loanPrincipal, underlying.loanEndTime, underlying.auctionEndTime);
    }

    function _getUnderlying(address nftContract, uint256 nftId) internal view returns (Underlying memory) {
        UnderlyingLookup memory lookup = nftIdToLookup[nftContract][nftId];
        return productIdToProduct[lookup.productId].underlyings[lookup.underlyingIndex];
    }

    function _getTokenPrice(uint256 productStartTime) internal view returns (uint256) {
        // Begin sale at price 1.1 ETH, and decay linearly by 0.1 ETH every day
        return Math.max(0, 11 * 10**17 - (block.timestamp - productStartTime) * 10**17 / DAY_IN_SECONDS);
    }

    function _getNftPrice(uint256 loanPrincipal, uint64 loanEndTime, uint256 auctionEndTime) internal view returns (uint256) {
        // Begin sale at price equal to 1.5x original loan principal, and decay linearly until 0 ETH at tranche payout time
        return Math.max(0, 3 * loanPrincipal * (auctionEndTime - block.timestamp) / (auctionEndTime - loanEndTime) / 2);
    }
}